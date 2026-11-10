/* ==========================================================================
   Billing view — the Enterprise plan and the payment walkthrough
   --------------------------------------------------------------------------
   Enterprise used to leave the payment flow entirely: its card was a mailto
   link, so a customer who wanted it had to write an email and wait, while Pro
   customers paid in four screens. Server-side the two are identical — the
   payments function prices `subscription:enterprise` and the admin approval
   activates the plan — so the gap was in this view.

   These tests drive the real billing.js in linkedom with the network, toast and
   modal modules stubbed, and click through the dialog as a customer would.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

let counter = 0;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const viewPath = path.join(repo, "public/js/modules/dashboard/views/billing.js");

/* ---------------------------------------------------------------- fixtures */

const SUBSCRIPTION = {
  plan: "pro",
  status: "active",
  current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
  ai_credits_used: 17
};

/** What the payments Edge Function returns from `create`. */
const CREATED = {
  reused: false,
  payment: {
    id: "pay-1",
    reference: "SZ-2026-0001",
    purpose: "subscription:enterprise",
    label: "Enterprise plan",
    amount: 999900,
    currency: "INR",
    status: "pending",
    plan: "enterprise",
    created_at: new Date().toISOString()
  },
  upi: {
    configured: true,
    upi_id: "shinzora@upi",
    payee_name: "Shinzora",
    intent: "upi://pay?pa=shinzora%40upi&am=9999.00&cu=INR",
    amount_rupees: 9999
  }
};

/* -------------------------------------------------------------- the render */

async function render(root, { planId = "pro" } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${root}</body></html>`);
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.FormData = window.FormData || class FormData {};
  globalThis.navigator = window.navigator || { userAgent: "node" };
  globalThis.getComputedStyle = window.getComputedStyle?.bind(window) || (() => ({ getPropertyValue: () => "" }));

  const calls = { create: [], proof: [], status: [] };
  const toasts = [];
  /* The modal is stubbed open: it returns the dialog it was handed, so the
     test can click the real footer buttons the view wired up. */
  globalThis.__modal = (options) => {
    const host = document.createElement("div");
    host.innerHTML = `${options.body || ""}${options.footer || ""}`;
    document.body.appendChild(host);
    const controller = {
      setFooter: (html) => {
        const footer = document.createElement("div");
        footer.innerHTML = html;
        host.appendChild(footer);
      },
      close: () => host.remove()
    };
    options.onMount?.(host, controller);
    return { host, controller };
  };
  globalThis.__toast = (message, tone) => toasts.push({ message, tone });
  globalThis.__api = {
    payments: {
      create: async (payload) => {
        calls.create.push(payload);
        /* The function prices the purpose itself; mirror it so the dialog shows
           the same number the server charged. */
        const plan = String(payload.purpose).split(":")[1];
        const amount = plan === "enterprise" ? 999900 : 249900;
        return {
          ...CREATED,
          payment: { ...CREATED.payment, purpose: payload.purpose, plan, amount, reference: `SZ-2026-${plan}` }
        };
      },
      submitProof: async (payload) => {
        calls.proof.push(payload);
        return { ok: true };
      },
      status: async (payload) => {
        calls.status.push(payload);
        return { payment: { status: "awaiting_verification" } };
      }
    },
    runtime: async () => ({ payments: { upi_id: "shinzora@upi", payee_name: "Shinzora" } })
  };

  const stub = {
    name: "billing-stubs",
    setup(build) {
      const files = {
        "store": `
          export const state = { profile: { plan: "pro", full_name: "Aditya" }, user: { email: "a@b.c", id: "u1" }, subscription: globalThis.__subscription };
          export const plan = () => globalThis.__plan;
          export const aiCredits = () => ({ used: 17, limit: 800, remaining: 783 });
        `,
        "data": `
          export const payments = async () => ({ data: [], error: null });
          export const subscription = async () => globalThis.__subscription;
        `,
        "api": `
          export const api = globalThis.__api;
          export const runtimeConfig = async () => globalThis.__api.runtime();
        `,
        "supabase": `
          export class AppError extends Error {
            constructor(message, code, hint) { super(message); this.code = code; this.hint = hint; }
          }
          export const sb = {
            from: () => ({
              insert: async () => ({ error: null }),
              select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }), order: () => ({ limit: async () => ({ data: [], error: null }) }), limit: async () => ({ data: [], error: null }) }),
              maybeSingle: async () => ({ data: null, error: null })
            })
          };
          export const normalizeError = (error) => error instanceof Error ? error : new AppError(String(error?.message || error));
        `,
        "modal": `
          export const openModal = (options) => globalThis.__modal(options);
          export const formDialog = async () => null;
          export const confirmDialog = async () => true;
        `,
        "toast": `
          export const toast = (message) => globalThis.__toast(message, "ok");
          export const toastError = (error) => globalThis.__toast(String(error?.message || error), "error");
        `
      };
      build.onResolve({ filter: /lib\/store\.js$/ }, () => ({ path: "store", namespace: "stub" }));
      /* billing imports it as "../data.js": the filter sees the specifier as
         written, not the resolved path. */
      build.onResolve({ filter: /(^|\/)data\.js$/ }, () => ({ path: "data", namespace: "stub" }));
      build.onResolve({ filter: /lib\/api\.js$/ }, () => ({ path: "api", namespace: "stub" }));
      build.onResolve({ filter: /lib\/supabase\.js$/ }, () => ({ path: "supabase", namespace: "stub" }));
      build.onResolve({ filter: /ui\/modal\.js$/ }, () => ({ path: "modal", namespace: "stub" }));
      build.onResolve({ filter: /ui\/toast\.js$/ }, () => ({ path: "toast", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: files[args.path], loader: "js" }));
    }
  };

  const result = await esbuild.build({
    entryPoints: [viewPath],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [stub]
  });
  const code = result.outputFiles[0].text;
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64") + "#" + ++counter;
  const view = await import(url);

  globalThis.__subscription = SUBSCRIPTION;
  globalThis.__plan = { id: planId, name: planId === "free" ? "Free" : "Pro", priceMonthly: planId === "free" ? 0 : 249900 };
  const target = document.querySelector(root ? "#billing-root" : "body");
  await view.default(target, { params: new URLSearchParams(), navigate: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { document, calls, toasts };
}

const click = (node) => {
  const event = new globalThis.window.Event("click", { bubbles: true });
  node.dispatchEvent(event);
};
const type = (document, selector, value) => {
  const input = document.querySelector(selector);
  input.value = value;
  return input;
};

const ROOT = `<div id="billing-root"></div>`;

/* -------------------------------------------------------------------- tests */

test("Enterprise is bought in-app, exactly like Pro", async () => {
  const { document } = await render(ROOT);

  const cards = Array.from(document.querySelectorAll(".plan-card"));
  const enterprise = cards.find((card) => /Enterprise/.test(card.textContent));
  assert.ok(enterprise, "the Enterprise card is missing");

  const button = enterprise.querySelector("[data-upgrade]");
  assert.ok(button, "Enterprise has no upgrade button — it fell back to a contact link");
  assert.equal(button.getAttribute("data-upgrade"), "enterprise");
  assert.equal(enterprise.querySelector("a[href^='mailto:']"), null, "Enterprise still routes to an email");
  assert.match(button.textContent, /Upgrade to Enterprise/);
});

test("Enterprise charges the server price, not a client-sent one", async () => {
  const { document, calls } = await render(ROOT);
  const card = Array.from(document.querySelectorAll(".plan-card")).find((node) => /Enterprise/.test(node.textContent));
  click(card.querySelector("[data-upgrade]"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].purpose, "subscription:enterprise");
  assert.equal(calls.create[0].plan, "enterprise");
  /* The amount the browser sends is advisory: the function prices the purpose
     itself. It still has to match, or the dialog would show the wrong number. */
  assert.equal(calls.create[0].amount, 999900);
});

test("the flow is UPI ID → 24-hour terms → QR → UTR → under process", async () => {
  const { document, calls, toasts } = await render(ROOT);
  const card = Array.from(document.querySelectorAll(".plan-card")).find((node) => /Enterprise/.test(node.textContent));
  click(card.querySelector("[data-upgrade]"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  /* 1 — the UPI ID is asked for first, so the bank entry can be matched. */
  const upi = document.querySelector("#payer-upi");
  assert.ok(upi, "the dialog does not ask for the payer's UPI ID");

  type(document, "#payer-upi", "not-a-upi");
  click(document.querySelector("#pay-next"));
  assert.equal(document.querySelector("#pay-terms-ok"), null, "an invalid UPI ID skipped ahead");
  assert.ok(toasts.some((t) => /UPI ID/.test(String(t.message?.title || t.message))), "no warning for a bad UPI ID");

  type(document, "#payer-upi", "aditya@okhdfcbank");
  click(document.querySelector("#pay-next"));

  /* 2 — the terms screen says what 24 hours means, before any money moves. */
  const consent = document.querySelector("#pay-terms-ok");
  assert.ok(consent, "the 24-hour terms screen is missing");
  const terms = document.querySelector(".pay-terms").textContent;
  assert.match(terms, /24 hours/);
  assert.match(terms, /under process/i);

  /* It cannot be skipped. */
  click(document.querySelector("#pay-next"));
  assert.equal(document.querySelector("#pay-qr-img"), null, "the QR opened without accepting the terms");

  consent.checked = true;
  click(document.querySelector("#pay-next"));

  /* 3 — the operator's own QR, not a generated placeholder. */
  const qr = document.querySelector("#pay-qr-img");
  assert.ok(qr, "no QR after the terms");
  assert.equal(qr.getAttribute("src"), "/assets/payments/upi-qr.png");
  assert.match(document.querySelector(".pay-amount-value").textContent, /9,999/);

  click(document.querySelector("#pay-next"));

  /* 4 — the UTR goes to the server; the browser cannot mark it paid. */
  assert.ok(document.querySelector("#utr"), "the UTR field is missing");
  type(document, "#utr", "123456789012");
  click(document.querySelector("#pay-next"));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(calls.proof.length, 1);
  assert.equal(calls.proof[0].paymentId, "pay-1");
  assert.equal(calls.proof[0].payerUpi, "aditya@okhdfcbank");

  /* 5 — the last screen says the payment is under process, not paid. */
  const done = document.body.textContent;
  assert.match(done, /Payment under process/);
  assert.match(done, /within 24 hours/);
  assert.doesNotMatch(done, /payment (is )?confirmed\./i);
});

test("Pro walks the same five screens as Enterprise", async () => {
  const { document, calls } = await render(ROOT, { planId: "free" });
  const pro = Array.from(document.querySelectorAll(".plan-card")).find((node) => /\bPro\b/.test(node.textContent));
  assert.ok(pro, "no Pro card");

  click(pro.querySelector("[data-upgrade]"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.create[0].purpose, "subscription:pro");

  type(document, "#payer-upi", "aditya@okhdfcbank");
  click(document.querySelector("#pay-next"));
  assert.ok(document.querySelector("#pay-terms-ok"), "Pro skipped the terms screen");
  document.querySelector("#pay-terms-ok").checked = true;
  click(document.querySelector("#pay-next"));
  assert.ok(document.querySelector("#pay-qr-img"), "Pro skipped the QR");
  click(document.querySelector("#pay-next"));
  assert.ok(document.querySelector("#utr"), "Pro skipped the UTR");
});
